$.fn.serializeObject = function()
{
    var o = {};
    var a = this.serializeArray();
    $.each(a, function() {
        if (o[this.name] !== undefined) {
            if (!o[this.name].push) {
                o[this.name] = [o[this.name]];
            }
            o[this.name].push(this.value || '');
        } else {
            o[this.name] = this.value || '';
        }
    });
    return o;
};



$( document ).ready(function() {
$("#main_search").click( function(){
	console.log($("#widget_booking_form").serializeObject());
	var formData = $("#widget_booking_form").serializeObject();
	//formData.doc_key = '1uEXAy8084e0NOZxAGUUwM4GjimSRF1r6_fZUJ_ERwQ8';
        formData.sheet = 'reservations';

	 $.post('https://script.google.com/macros/s/AKfycby_r2OMzTjjYPudrwVDhqnR8iaOOkfgg2H9A99WuSnwgAs0F5M3/exec', formData, function(data){
            console.log(data);
           $("<a href='error.html'></a>").click(); 
		//like if you click on a link (it will be saved in the session history, 
//so the back button will work as expected)
location.href = "http://www.hudsongetaways.com/error.html";
		
          });
});


$("#bora_contact_btn").click( function(){
	console.log($("#bora_contact").serializeObject());
	var formData = $("#bora_contact").serializeObject();
	//formData.doc_key = '1uEXAy8084e0NOZxAGUUwM4GjimSRF1r6_fZUJ_ERwQ8';
        formData.sheet = 'contact';

	 $.post('https://script.google.com/macros/s/AKfycby_r2OMzTjjYPudrwVDhqnR8iaOOkfgg2H9A99WuSnwgAs0F5M3/exec', formData, function(data){
            console.log(data);

          });
});

  $( function() {
    var dateToday = new Date();
    var dates = $("#start-date, #end-date").datepicker({
      defaultDate: "+2d",
      changeMonth: true,
      numberOfMonths: 8,
      minDate: dateToday,
      onSelect: function(selectedDate) {
          var option = this.id == "start-date" ? "minDate" : "maxDate",
          instance = $(this).data("datepicker"),
          date = $.datepicker.parseDate(instance.settings.dateFormat || $.datepicker._defaults.dateFormat, selectedDate, instance.settings);
          dates.not(this).datepicker("option", option, date);
      }
    });
  });
});